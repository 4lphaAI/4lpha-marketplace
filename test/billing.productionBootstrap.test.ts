import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { EnabledBillingConfig } from "../src/billing/config.js";
import {
  loadBillingProductionBootstrap,
  validateBillingProductionBootstrapBytes,
} from "../src/billing/productionBootstrap.js";
import { canonicalProductionManifest } from "../src/billing/productionManifest.js";
import { GOLDEN_PRODUCTION_MANIFEST_V2 } from "./fixtures/billing/productionManifestV2.js";

function config(value: Record<string, unknown>): EnabledBillingConfig {
  const collector = value["collector"] as Record<string, string>;
  const aws = value["aws"] as Record<string, string>;
  const networks = value["networks"] as Record<string, Record<string, unknown>>;
  const caps = value["caps"] as Record<string, string>;
  const providers = value["providers"] as Record<string, unknown>;
  return {
    mode: "on", x402: "on", og: "off", internalHost: "127.0.0.1", internalPort: 8091,
    databaseUrl: "postgres://billing.invalid/db", executionMasterKeyPresent: true,
    collector: collector["address"] as `0x${string}`,
    collectorRuntimeBytecodeHash: collector["runtimeCodehash"] as `0x${string}`,
    treasury: collector["treasury"] as `0x${string}`,
    executionTicketKeyId: aws["ticketKeyId"]!, executionTicketPublicKey: "ticket-public-key",
    bscRpcOrigins: networks["bsc"]!["origins"] as readonly [string, string],
    baseRpcOrigins: networks["base"]!["origins"] as readonly [string, string],
    arbitrumRpcOrigins: networks["arbitrum"]!["origins"] as readonly [string, string],
    platformBaseUsdcCapAtomic: BigInt(caps["platformUsdcAtomic"]!),
    platformOgCapNeuron: BigInt(caps["platformOgNeuron"]!),
    x402PayerKeyId: "x402", x402Authorizer: providers["x402Authorizer"] as `0x${string}`,
  };
}

test("production bootstrap binds local manifest and bundle before any external seam", async () => {
  const root = await mkdtemp(join(tmpdir(), "billing-bootstrap-"));
  const manifestPath = join(root, "manifest.json");
  const bundlePath = join(root, "adapter.mjs");
  const bundle = Buffer.from("export const offline = true;", "utf8");
  const value = JSON.parse(GOLDEN_PRODUCTION_MANIFEST_V2) as Record<string, unknown>;
  value["bundleSha256"] = createHash("sha256").update(bundle).digest("hex");
  const manifest = Buffer.from(canonicalProductionManifest(value), "utf8");
  try {
    await Promise.all([writeFile(manifestPath, manifest), writeFile(bundlePath, bundle)]);
    await chmod(manifestPath, 0o600);
    const env = {
      EXECUTION_NETWORK: "mainnet",
      BILLING_PRODUCTION_MANIFEST_PATH: manifestPath,
      BILLING_PRODUCTION_BUNDLE_PATH: bundlePath,
    };
    const loaded = validateBillingProductionBootstrapBytes({
      config: config(value), env, manifestBytes: manifest, bundleBytes: bundle,
      bundleUrl: "file:///reviewed-adapter.mjs",
    });
    assert.equal(loaded.manifest.bundleSha256, value["bundleSha256"]);
    await assert.rejects(loadBillingProductionBootstrap(config(value), env, "win32"), /permissions-unverified/);
    await assert.rejects(loadBillingProductionBootstrap(config(value), {
      ...env, AWS_ACCESS_KEY_ID: "forbidden",
    }, "linux"), /credential sources/);
    for (const name of ["AWS_ENDPOINT_URL_STS", "AWS_ENDPOINT_URL_KMS",
      "AWS_ENDPOINT_URL_SECRETS_MANAGER"]) {
      assert.throws(() => validateBillingProductionBootstrapBytes({ config: config(value),
        env: { ...env, [name]: "" }, manifestBytes: manifest, bundleBytes: bundle,
        bundleUrl: "file:///reviewed-adapter.mjs" }), /credential sources/, name);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
