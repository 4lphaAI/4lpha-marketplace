import type { EnabledBillingConfig } from "./config.js";
import {
  createBillingProductionRuntime,
  type BillingProductionRuntime,
} from "./production.js";

export type { BillingProductionRuntime } from "./production.js";

/**
 * Construct the reviewed core-owned production topology only in explicit ON
 * mode. The concrete factory accepts a narrow infrastructure adapter but never
 * an application/gateway/store supplied by deployment code.
 */
export async function loadBillingProductionRuntime(
  config: EnabledBillingConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BillingProductionRuntime> {
  const runtime = await createBillingProductionRuntime(config, env);
  if (
    runtime === null || typeof runtime !== "object" ||
    runtime.owner.store !== runtime.store || runtime.worker.store !== runtime.store ||
    typeof runtime.gateway.fetch !== "function" || typeof runtime.close !== "function"
  ) {
    throw new Error("Billing production runtime does not share one reviewed store/gateway composition.");
  }
  return runtime;
}
