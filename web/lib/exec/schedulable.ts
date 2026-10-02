import { execServiceRead } from "./client";

export type SchedulableTokenDto = {
  readonly address: string;
  readonly symbol: string;
  readonly underlyingTicker: string | null;
  readonly platform: string | null;
  readonly decimals?: number;
  readonly quotedOutAtomic: string;
  readonly venue: string;
  readonly liquidityUsd: number | null;
};

export type SchedulableResponse = {
  readonly amountWei: string;
  readonly slippageBps: number;
  readonly asOf: number;
  readonly tokens: readonly SchedulableTokenDto[];
};

export async function fetchSchedulable(amountWei: string, slippageBps: number, signal?: AbortSignal): Promise<SchedulableResponse> {
  const query = new URLSearchParams({ amountWei, slippageBps: String(slippageBps) });
  const response = await fetch(`/api/agents/hire/schedulable?${query}`, { cache: "no-store", ...(signal === undefined ? {} : { signal }) });
  const payload = await response.json() as { readonly data?: SchedulableResponse; readonly error?: { readonly message?: string; readonly code?: string } };
  if (!response.ok || payload.data === undefined) throw new Error(payload.error?.message ?? payload.error?.code ?? `HTTP ${response.status}`);
  return payload.data;
}
