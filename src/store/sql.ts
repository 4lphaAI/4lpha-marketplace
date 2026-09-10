/**
 * The narrow SQL seam the Postgres-backed stores depend on.
 *
 * Everything durable in Phase 1a goes through `SqlClient` rather than reaching
 * for `pg` directly. Two payoffs:
 *   - the Postgres store code is exercised offline against an in-memory client
 *     that speaks the same interface, so its parameter ordering, jsonb
 *     encoding and owner scoping are all covered without a live database;
 *   - `pg` is imported only at runtime, inside {@link createPgSqlClient}, so the
 *     driver is not a compile-time or test-time dependency. A deployment that
 *     sets `DATABASE_URL` must install `pg`; nothing else needs it.
 */

/** Result of a query. Rows are typed by the caller. */
export type SqlResult<Row> = {
  readonly rows: readonly Row[];
};
export type SqlQueryOptions = { readonly signal?: AbortSignal; readonly timeoutMs?: number };

/**
 * A minimal SQL executor. Parameterized statements ONLY — callers pass values
 * as `$n` bind parameters and never interpolate them into the text.
 */
export interface SqlClient {
  query<Row = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
    options?: SqlQueryOptions,
  ): Promise<SqlResult<Row>>;
  /**
   * Run `fn` inside a transaction. The `tx` passed to `fn` executes on a single
   * pinned connection, which is what makes `select ... for update` serialize
   * concurrent same-key operations. Rolls back on throw.
   */
  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Runtime-only pg binding                                                    */
/* -------------------------------------------------------------------------- */

type PgQueryResult = { readonly rows: readonly unknown[] };

type PgQueryConfig = { readonly text: string; readonly values: readonly unknown[]; readonly query_timeout?: number; readonly signal?: AbortSignal };
type PgPoolClient = {
  query(text: string | PgQueryConfig, params?: readonly unknown[]): Promise<PgQueryResult>;
  release(): void;
};

type PgPool = {
  query(text: string | PgQueryConfig, params?: readonly unknown[]): Promise<PgQueryResult>;
  connect(): Promise<PgPoolClient>;
  end(): Promise<void>;
};

type PgModule = {
  readonly default: {
    readonly Pool: new (config: { connectionString: string }) => PgPool;
  };
};

/**
 * Load `pg` at runtime and return a {@link SqlClient} backed by a connection
 * pool. The dynamic specifier keeps `pg` out of the type graph, so offline
 * builds and tests never require it; a missing driver surfaces here, at the
 * point a Postgres connection is actually requested.
 */
export async function createPgSqlClient(
  connectionString: string,
): Promise<SqlClient> {
  const specifier = "pg";
  const mod = (await import(specifier)) as unknown as PgModule;
  const pool = new mod.default.Pool({ connectionString });

  const fromPool: SqlClient = {
    async query<Row>(text: string, params?: readonly unknown[], options?: SqlQueryOptions) {
      const result = options === undefined
        ? await pool.query(text, params)
        : await pool.query({ text, values: params ?? [], ...(options.timeoutMs === undefined ? {} : { query_timeout: options.timeoutMs }), ...(options.signal === undefined ? {} : { signal: options.signal }) });
      return { rows: result.rows as readonly Row[] };
    },
    async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
      const connection = await pool.connect();
      const tx: SqlClient = {
        async query<Row>(text: string, params?: readonly unknown[], options?: SqlQueryOptions) {
          const result = options === undefined
            ? await connection.query(text, params)
            : await connection.query({ text, values: params ?? [], ...(options.timeoutMs === undefined ? {} : { query_timeout: options.timeoutMs }), ...(options.signal === undefined ? {} : { signal: options.signal }) });
          return { rows: result.rows as readonly Row[] };
        },
        // Already inside a transaction: run inline rather than nesting BEGIN.
        transaction: (nested) => nested(tx),
        close: async () => {},
      };
      try {
        await connection.query("begin");
        const result = await fn(tx);
        await connection.query("commit");
        return result;
      } catch (error) {
        await connection.query("rollback");
        throw error;
      } finally {
        connection.release();
      }
    },
    async close() {
      await pool.end();
    },
  };

  return fromPool;
}
