import { createAwsBillingProductionFactory } from "./awsBillingProduction.internal.js";
import { createAwsBillingSessionIdentityReader,
  type BillingSessionKmsIdentityReaderV1,
  type VerifiedBillingSessionKmsIdentityV1 } from "./awsBillingSessionIdentity.js";
import type {
  BillingAdapterConfigV2,
  ProductionBillingCustodyAndRelayPrimitives,
} from "./custody.js";

const productionFactory = createAwsBillingProductionFactory({ environment: process.env });

/** Separately authorized identity-only entry point; it has no signing or relay capability. */
export async function readBillingSessionKmsIdentity(
  input: Parameters<BillingSessionKmsIdentityReaderV1["read"]>[0],
): Promise<VerifiedBillingSessionKmsIdentityV1> {
  return createAwsBillingSessionIdentityReader({ environment: process.env }).read(input);
}

/** Exact production artifact entry point. No env, client, transport or callback crosses this ABI. */
export async function createBillingCustodyAndRelayPrimitives(
  config: BillingAdapterConfigV2,
): Promise<ProductionBillingCustodyAndRelayPrimitives> {
  return productionFactory(config);
}
