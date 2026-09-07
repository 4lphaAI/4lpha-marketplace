import { createEcsAwsBillingProductionFactory } from "./awsBillingProduction.internal.js";
import { createEcsAwsBillingSessionIdentityReader,
  type BillingSessionKmsIdentityReaderV1 } from "./awsBillingSessionIdentity.js";
import type { BillingAdapterConfigV2, ProductionBillingCustodyAndRelayPrimitives } from "./custody.js";

const ecsProductionFactory = createEcsAwsBillingProductionFactory({ environment: process.env });
const ecsIdentityReader = createEcsAwsBillingSessionIdentityReader({ environment: process.env });

export async function readBillingSessionKmsIdentity(
  input: Parameters<BillingSessionKmsIdentityReaderV1["read"]>[0],
): ReturnType<BillingSessionKmsIdentityReaderV1["read"]> {
  return ecsIdentityReader.read(input);
}

/** Exact non-Railway ECS artifact entry; it refuses Roles Anywhere before any AWS client or file work. */
export async function createBillingCustodyAndRelayPrimitives(
  config: BillingAdapterConfigV2,
): Promise<ProductionBillingCustodyAndRelayPrimitives> {
  return ecsProductionFactory(config);
}
