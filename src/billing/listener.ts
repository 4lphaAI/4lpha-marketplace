import { serve } from "@hono/node-server";
import type { Hono } from "hono";

export type BillingInternalListener = ReturnType<typeof serve>;

/** Bind the paid gateway to a separate literal loopback socket. */
export function listenBillingInternalGateway(input: Readonly<{
  app: Hono;
  host: "127.0.0.1" | "::1";
  port: number;
}>): BillingInternalListener {
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) {
    throw new Error("Billing internal listener port is invalid.");
  }
  return serve({ fetch: input.app.fetch, hostname: input.host, port: input.port });
}
