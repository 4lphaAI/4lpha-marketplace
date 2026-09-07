/**
 * SERVER-ONLY execution-plane fetcher (the BFF half of the trust boundary).
 *
 * `EXECUTION_API_TOKEN` never reaches the browser; owner-signed envelopes are
 * forwarded BYTES-UNCHANGED (the plane recomputes `paramsHash` over the exact
 * `params` it receives, so the BFF must never re-serialize a mutation body).
 */
// Poor-man's `server-only` (the package conflicts with this tree's TS 7 peer
// graph): fail loudly if this module ever reaches a browser bundle.
if (typeof window !== "undefined") {
  throw new Error("lib/exec/client.ts is server-only; it must never be bundled for the browser.");
}

const DEFAULT_TIMEOUT_MS = 30_000;

function execBaseUrl(): string {
  const url = process.env["EXECUTION_URL"]?.trim();
  if (!url) throw new Error("EXECUTION_URL is not configured.");
  return url.replace(/\/$/u, "");
}

function execToken(): string {
  const token = process.env["EXECUTION_API_TOKEN"]?.trim();
  if (!token) throw new Error("EXECUTION_API_TOKEN is not configured.");
  return token;
}

export type ExecResponse = {
  readonly status: number;
  /** Raw body text — passed through verbatim so refusal text is never rewritten. */
  readonly body: string;
};

async function forward(
  path: string,
  init: { method: "GET" | "POST"; headers?: Record<string, string>; body?: string },
): Promise<ExecResponse> {
  const response = await fetch(`${execBaseUrl()}${path}`, {
    method: init.method,
    headers: {
      accept: "application/json",
      "x-exec-token": execToken(),
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
    ...(init.body !== undefined ? { body: init.body } : {}),
    cache: "no-store",
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  return { status: response.status, body: await response.text() };
}

/** Owner-signed read: the base64url envelope rides the x-owner-action header. */
export function execOwnerRead(path: string, ownerActionHeader: string): Promise<ExecResponse> {
  return forward(path, { method: "GET", headers: { "x-owner-action": ownerActionHeader } });
}

/** Exact accepted Trading S1, scoped only to its own hire-session continuation. */
export function execProvisionContinuationRead(path: string, provisionActionHeader: string): Promise<ExecResponse> {
  return forward(path, { method: "GET", headers: { "x-provision-action": provisionActionHeader } });
}

/** Account-only read session; the bearer is minted by the execution plane. */
export function execAccountRead(path: string, bearer: string): Promise<ExecResponse> {
  return forward(path, { method: "GET", headers: { authorization: `Bearer ${bearer}` } });
}

/**
 * A plane read that takes only the service perimeter (no owner action) —
 * today just the pool-state read the grid geometry is derived from.
 */
export function execServiceRead(path: string): Promise<ExecResponse> {
  return forward(path, { method: "GET" });
}

/** Owner-signed mutation: the raw JSON body is forwarded byte-for-byte. */
export function execOwnerMutation(path: string, rawBody: string): Promise<ExecResponse> {
  return forward(path, { method: "POST", body: rawBody });
}

/**
 * DEMO MODE — a service-perimeter call carrying the anonymous demo owner id.
 *
 * The id is minted and kept by the BFF in an HttpOnly cookie (see
 * `app/api/demo/[...path]/route.ts`) and forwarded as a header, exactly as
 * `x-exec-token` is: the browser never sees either. A demo agent holds no
 * funds, no key and no authority, so this is the whole credential — and the
 * worst a stolen one buys is somebody else's simulation.
 */
export function execDemo(
  path: string,
  demoOwnerId: string,
  init: { method: "GET" | "POST"; body?: string },
): Promise<ExecResponse> {
  return forward(path, {
    method: init.method,
    headers: { "x-demo-owner": demoOwnerId },
    ...(init.body === undefined ? {} : { body: init.body }),
  });
}
