import { fail, type IdentityBinding, type IdentityFence } from "./types.js";

export class MemoryIdentityFence implements IdentityFence {
  #live = true;
  check(): void { if (!this.#live) fail("lock_lost"); }
  async close(): Promise<void> { this.#live = false; }
}
export interface LockConnection {
  query(text: string, params?: readonly unknown[]): Promise<{ readonly rows: readonly { readonly locked?: boolean }[] }>;
  on(event: "error" | "end", listener: () => void): unknown;
  end(): Promise<void>;
}
export async function acquireIdentityFence(connection: LockConnection, binding: IdentityBinding): Promise<IdentityFence> {
  let live = true;
  connection.on("error", () => { live = false; }); connection.on("end", () => { live = false; });
  const check = () => { if (!live) fail("lock_lost"); };
  try {
    const result = await connection.query(`select pg_try_advisory_lock(hashtextextended($1,0)) as locked`, [`4lpha:erc8004:v1:${binding.chainId}:${binding.minter.toLowerCase()}`]);
    check(); if (result.rows[0]?.locked !== true) fail("lock_busy");
  } catch (error) { live = false; await connection.end().catch(() => {}); throw error; }
  return { check, async close() { live = false; await connection.end(); } };
}
export async function createIdentityFence(databaseUrl: string, binding: IdentityBinding): Promise<IdentityFence> {
  const { Client } = await import("pg");
  const connection = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10_000, query_timeout: 15_000, keepAlive: true });
  // An error while connecting must not become an unhandled EventEmitter error.
  connection.on("error", () => {});
  try { await connection.connect(); return await acquireIdentityFence(connection, binding); }
  catch (error) { await connection.end().catch(() => {}); throw error; }
}
