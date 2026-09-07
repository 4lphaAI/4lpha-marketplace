/**
 * DEMO MODE — the browser's view of a demo agent.
 *
 * Hand-written DTOs, like every other execution-plane type in `web/`: this app
 * never imports from `../src/`, and the demo plane is reached over HTTP through
 * the BFF at `/api/demo/*` exactly as an external client would reach it.
 *
 * WEI CROSSES AS DECIMAL TEXT. The plane serialises every amount that way
 * (`jsonSafe` in `src/demo/routes.ts`), because a wei figure does not fit in a
 * JavaScript number and a demo that rounded one would be lying about the only
 * thing it produces.
 */

export type DemoDisclosure = {
  readonly simulated: true;
  readonly omits: readonly string[];
};

export type DemoGridLevelView = {
  readonly level: 1 | 2;
  readonly role: "buy" | "sell";
  readonly range: { readonly tickLower: number; readonly tickUpper: number } | null;
  readonly cycles: number;
  readonly realisedQuoteWei: string;
};

export type DemoGridDetail = {
  readonly pool: string;
  readonly quoteSymbol: string;
  readonly baseSymbol: string;
  readonly budgetQuoteWei: string;
  readonly tickSpacing: number;
  readonly wbnbIsToken0: boolean;
  /**
   * The tick the last cycle acted on, and when it was read. `null` before the
   * first cycle, and NEVER presented as "now" — a screen ages it.
   */
  readonly currentTick: number | null;
  readonly currentTickAtMs: number | null;
  readonly levels: readonly DemoGridLevelView[];
  readonly flips: number;
  readonly cycles: number;
  readonly realisedQuoteWei: string;
  readonly gasChargedQuoteWei: string;
  readonly netQuoteWei: string;
};

export type DemoTradePositionView = {
  readonly token: string;
  readonly symbol: string;
  readonly entryQuoteWei: string;
  readonly openedAtMs: number;
};

export type DemoTradeDetail = {
  readonly model: string;
  readonly capitalQuoteWei: string;
  readonly cashQuoteWei: string;
  readonly universeSize: number;
  readonly brainEnabled: boolean;
  readonly positions: readonly DemoTradePositionView[];
  readonly trades: number;
  readonly realisedQuoteWei: string;
  readonly gasChargedQuoteWei: string;
  readonly netQuoteWei: string;
};

export type DemoAgentView = {
  readonly id: string;
  readonly kind: "grid" | "trade";
  readonly name: string;
  readonly status: "running" | "stopped" | "expired";
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly lastTickAtMs: number | null;
  /** Why it is not advancing. A screen shows THIS, never a number in its place. */
  readonly holdReason: string | null;
  readonly detail: DemoGridDetail | DemoTradeDetail | null;
  readonly detailUnavailableReason: string | null;
  readonly disclosure: DemoDisclosure;
  /** Always null. A demo has no transaction, no NFT and no registry id. */
  readonly txHash: null;
  readonly tokenId: null;
  readonly erc8004AgentId: null;
  readonly callsId: null;
};

export type DemoFillView = {
  readonly seq: number;
  readonly atMs: number;
  readonly kind: string;
  readonly [key: string]: unknown;
};

export class DemoError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

async function call<T>(path: string, init?: { method: "POST"; body?: unknown }): Promise<T> {
  const response = await fetch(`/api/demo/${path}`, {
    method: init?.method ?? "GET",
    ...(init?.body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) }),
  });
  const payload = (await response.json()) as { data?: T; error?: { code: string; message?: string } };
  if (!response.ok || payload.data === undefined) {
    throw new DemoError(payload.error?.code ?? `http_${response.status}`, payload.error?.message);
  }
  return payload.data;
}

export function listDemoAgents(): Promise<{ agents: readonly DemoAgentView[] }> {
  return call("agents");
}

export function readDemoAgent(id: string): Promise<{ agent: DemoAgentView }> {
  return call(`agents/${encodeURIComponent(id)}`);
}

export function readDemoFills(
  id: string,
): Promise<{ fills: readonly DemoFillView[]; disclosure: DemoDisclosure }> {
  return call(`agents/${encodeURIComponent(id)}/fills`);
}

export function stopDemoAgent(id: string): Promise<{ agent: DemoAgentView }> {
  return call(`agents/${encodeURIComponent(id)}/stop`, { method: "POST" });
}

/** Render a decimal-text wei amount as BNB, with a fixed number of places. */
export function formatBnb(wei: string, places = 5): string {
  let value: bigint;
  try {
    value = BigInt(wei);
  } catch {
    return "—";
  }
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const whole = magnitude / 10n ** 18n;
  const fraction = (magnitude % 10n ** 18n).toString().padStart(18, "0").slice(0, places);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

export function isGridDetail(
  agent: DemoAgentView,
): agent is DemoAgentView & { detail: DemoGridDetail } {
  return agent.kind === "grid" && agent.detail !== null;
}

export function isTradeDetail(
  agent: DemoAgentView,
): agent is DemoAgentView & { detail: DemoTradeDetail } {
  return agent.kind === "trade" && agent.detail !== null;
}
