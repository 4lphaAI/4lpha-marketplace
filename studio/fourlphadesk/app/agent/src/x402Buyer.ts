/**
 * x402 micropay buyer (fixed code), derived from `bag recipe code x402-buyer`.
 *
 * This desk buys ONE data point per job from a hardcoded URL (see desk/backdrop.ts). The recipe's LLM
 * tool set (`buy_with_x402`, `quote_x402`) was deleted on purpose: the model must never have a payment
 * tool available to wire. Only `buyWithX402` remains, and only fixed code calls it.
 *
 * Security spine (all enforced in @bnbagent/studio-runtime, not here):
 *   - recipient: the pinned merchant `pay_to` is byte-compared against the 402's payTo, so a tampered
 *     402 can never redirect funds;
 *   - per-call cap: `merchants.<name>.per_call_cap_usd` clamps every payment regardless of `maxUsd`;
 *   - daily cap: `[budget].max_per_day_usd` across all paid calls;
 *   - host allowlist: `[payments.x402].allowed_hosts` plus every trusted merchant domain.
 *
 * You own this file; edit freely.
 */

import { loadStudioToml } from "@bnbagent/studio-runtime/config";
import { getWallet } from "@bnbagent/studio-runtime/wallet";
import { fetchWithPayment, X402BuyerPolicy, X402Error } from "@bnbagent/studio-runtime/x402";

type FetchWithPayment = typeof fetchWithPayment;

/** Test seams. Production passes nothing. */
export interface BuyDeps {
  readonly fetchWithPayment?: FetchWithPayment;
  readonly policy?: () => X402BuyerPolicy;
  readonly wallet?: () => Parameters<FetchWithPayment>[1]["wallet"];
  readonly fetchImpl?: typeof fetch;
}

/**
 * Pay an x402-protected endpoint and return its response.
 *
 * NO API KEY IS REQUIRED: the merchant authenticates the caller by the on-chain EIP-3009 payment signed
 * with the agent's own wallet. URL host must be on the effective allowlist. `maxUsd` is only a refusal
 * threshold: the actual price comes from the endpoint's 402 challenge, and the config's per-call and
 * daily caps still apply on top.
 */
export async function buyWithX402(
  url: string,
  maxUsd: number,
  method = "GET",
  deps: BuyDeps = {},
): Promise<Record<string, unknown>> {
  const pol = (deps.policy ?? (() => X402BuyerPolicy.fromToml(loadStudioToml())))();
  const pay = deps.fetchWithPayment ?? fetchWithPayment;
  try {
    const result = await pay(url, {
      maxUsd: Math.min(maxUsd, pol.maxPerRequestUsd),
      wallet: (deps.wallet ?? getWallet)(),
      method,
      allowedHosts: [...pol.effectiveAllowedHosts],
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    });
    return {
      ok: true,
      status: result.statusCode,
      json: result.json,
      paid_usd: result.paidUsd,
      // desk edit: keep the settlement transaction so the delivered report can cite it
      settlement_tx: result.settlement?.transaction ?? null,
    };
  } catch (exc) {
    if (exc instanceof X402Error) {
      // `name` is set explicitly by every runtime error class (constructor.name can be mangled by a bundler)
      return { ok: false, error: exc.name, message: exc.message };
    }
    throw exc;
  }
}
