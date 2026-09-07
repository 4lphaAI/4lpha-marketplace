import { Client } from "pg";

export const WORKER_LOCK_NAMESPACE = 879_521_896;

export type WorkerSingletonRole = "lp-worker" | "venus-worker" | "billing-worker-once";

const ROLE_KEYS: Readonly<Record<WorkerSingletonRole, 1 | 2 | 3>> = Object.freeze({
  "lp-worker": 1,
  "venus-worker": 2,
  "billing-worker-once": 3,
});

const LOCK_SQL = "SELECT pg_try_advisory_lock($1::integer, $2::integer) AS locked";
const UNLOCK_SQL = "SELECT pg_advisory_unlock($1::integer, $2::integer) AS unlocked";

type LockRow = Record<string, unknown>;

export interface WorkerLockClient {
  connect(): Promise<void>;
  query(text: string, values: readonly number[]): Promise<Readonly<{ rows: readonly LockRow[] }>>;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "end", listener: () => void): this;
  end(): Promise<void>;
}

class PgWorkerLockClient implements WorkerLockClient {
  readonly #client: Client;

  constructor(databaseUrl: string) {
    this.#client = new Client({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 5_000,
      query_timeout: 5_000,
      statement_timeout: 5_000,
      application_name: "4lpha-worker-singleton",
    });
  }

  async connect(): Promise<void> {
    await this.#client.connect();
  }

  async query(text: string, values: readonly number[]): Promise<Readonly<{ rows: readonly LockRow[] }>> {
    return this.#client.query<LockRow>(text, [...values]);
  }

  on(event: "error" | "end", listener: ((error: Error) => void) | (() => void)): this {
    if (event === "error") this.#client.on("error", listener as (error: Error) => void);
    else this.#client.on("end", listener as () => void);
    return this;
  }

  end(): Promise<void> {
    return this.#client.end();
  }
}

export type WorkerFence = Readonly<{
  signal: AbortSignal;
  isFatal(): boolean;
  assertOpen(): void;
}>;

export class WorkerFenceFatalError extends Error {
  constructor() {
    super("Worker singleton authority was lost.");
    this.name = "WorkerFenceFatalError";
  }
}

type MutableWorkerFence = WorkerFence & Readonly<{ latchFatal(): boolean }>;

function createWorkerFence(): MutableWorkerFence {
  const controller = new AbortController();
  let fatal = false;
  return Object.freeze({
    signal: controller.signal,
    isFatal: () => fatal,
    assertOpen(): void {
      if (fatal) throw new WorkerFenceFatalError();
    },
    latchFatal(): boolean {
      if (fatal) return false;
      fatal = true;
      controller.abort(new Error("Worker singleton authority was lost."));
      return true;
    },
  });
}

export function assertWorkerFence(fence: WorkerFence): void {
  fence.assertOpen();
}

/** Guard an external function with no asynchronous gap before invocation. */
export function fenceWorkerFunction<Args extends readonly unknown[], Result>(
  fence: WorkerFence,
  operation: (...args: Args) => Result,
): (...args: Args) => Result {
  return (...args: Args): Result => {
    fence.assertOpen();
    return operation(...args);
  };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && "then" in value &&
    typeof Reflect.get(value, "then") === "function";
}

/**
 * Guard every method on a provider/store dependency. Reflect.apply keeps the
 * original receiver, including classes whose methods use private fields.
 */
export type WorkerFenceSignalMode = "none" | "object-first" | "last";

export function fenceWorkerDependency<T extends object>(
  fence: WorkerFence,
  dependency: T,
  signalMode: WorkerFenceSignalMode = "none",
): T {
  const proxies = new WeakMap<object, object>();
  const wrap = <Value extends object>(target: Value): Value => {
    const existing = proxies.get(target);
    if (existing !== undefined) return existing as Value;
    const methods = new Map<PropertyKey, (...args: readonly unknown[]) => unknown>();
    const proxy = new Proxy(target, {
      get(current, property): unknown {
        fence.assertOpen();
        const value = Reflect.get(current, property, current);
        if (typeof value === "object" && value !== null) return wrap(value);
        if (typeof value !== "function") return value;
        const cached = methods.get(property);
        if (cached !== undefined) return cached;
        const invoke = (...args: readonly unknown[]): unknown => {
          fence.assertOpen();
          let boundaryArgs = args;
          if (signalMode === "last") boundaryArgs = [...args, fence.signal];
          else if (signalMode === "object-first") {
            const first = args[0];
            if (typeof first === "object" && first !== null && !Array.isArray(first)) {
              boundaryArgs = [{ ...first, signal: fence.signal }, ...args.slice(1)];
            }
          }
          const result = Reflect.apply(value, current, boundaryArgs);
          if (!isPromiseLike(result)) return result;
          return Promise.resolve(result).then((resolved) => {
            fence.assertOpen();
            return resolved;
          });
        };
        // An async function can do useful work synchronously before its first
        // await. Defer its invocation by one microtask so a lock-loss event in
        // the caller's current turn wins before any such work starts. Each
        // later dependency call is independently guarded by this deep proxy.
        const guarded = value.constructor?.name === "AsyncFunction"
          ? (...args: readonly unknown[]): Promise<unknown> =>
              Promise.resolve().then(() => invoke(...args))
          : invoke;
        methods.set(property, guarded);
        return guarded;
      },
    });
    proxies.set(target, proxy);
    return proxy;
  };
  return wrap(dependency);
}

export type WorkerDelayDependencies = Readonly<{
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
}>;

const REAL_DELAY_DEPENDENCIES: WorkerDelayDependencies = Object.freeze({
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
});

export type WorkerGracefulDrainDependencies = WorkerDelayDependencies & Readonly<{
  terminate(code: number): void;
  reportTimeout(message: string): void;
}>;

export type WorkerGracefulDrain = Readonly<{
  signal: AbortSignal;
  isStopping(): boolean;
  requestStop(): void;
  complete(): void;
}>;

const REAL_GRACEFUL_DRAIN_DEPENDENCIES: WorkerGracefulDrainDependencies = Object.freeze({
  ...REAL_DELAY_DEPENDENCIES,
  terminate: (code) => process.exit(code),
  reportTimeout: (message) => console.error(message),
});

/** Bounded operator drain. Lock-loss uses the separate immediate fatal path. */
export function createWorkerGracefulDrain(input: Readonly<{
  label: string;
  timeoutMs?: number;
  dependencies?: WorkerGracefulDrainDependencies;
}>): WorkerGracefulDrain {
  const dependencies = input.dependencies ?? REAL_GRACEFUL_DRAIN_DEPENDENCIES;
  const timeoutMs = input.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Worker graceful drain timeout is invalid.");
  }
  const controller = new AbortController();
  let stopping = false;
  let complete = false;
  let timer: unknown;
  return Object.freeze({
    signal: controller.signal,
    isStopping: () => stopping,
    requestStop(): void {
      if (stopping || complete) return;
      stopping = true;
      controller.abort();
      timer = dependencies.setTimer(() => {
        if (complete) return;
        dependencies.reportTimeout(`[${input.label}] graceful drain exceeded ${timeoutMs}ms`);
        dependencies.terminate(1);
      }, timeoutMs);
    },
    complete(): void {
      if (complete) return;
      complete = true;
      if (timer !== undefined) dependencies.clearTimer(timer);
    },
  });
}

/** A cycle wait that stops in the same turn as lock loss or graceful shutdown. */
export function waitForWorkerDelay(input: Readonly<{
  delayMs: number;
  fence: WorkerFence;
  gracefulSignal?: AbortSignal;
  dependencies?: WorkerDelayDependencies;
}>): Promise<"elapsed" | "stopped"> {
  input.fence.assertOpen();
  if (input.delayMs <= 0) return Promise.resolve("elapsed");
  if (input.gracefulSignal?.aborted === true) return Promise.resolve("stopped");
  const dependencies = input.dependencies ?? REAL_DELAY_DEPENDENCIES;
  return new Promise((resolve) => {
    let settled = false;
    let handle: unknown;
    const finish = (result: "elapsed" | "stopped"): void => {
      if (settled) return;
      settled = true;
      dependencies.clearTimer(handle);
      input.fence.signal.removeEventListener("abort", stop);
      input.gracefulSignal?.removeEventListener("abort", stop);
      resolve(result);
    };
    const stop = (): void => finish("stopped");
    handle = dependencies.setTimer(() => finish("elapsed"), input.delayMs);
    input.fence.signal.addEventListener("abort", stop, { once: true });
    input.gracefulSignal?.addEventListener("abort", stop, { once: true });
  });
}

export type WorkerSingletonLease = Readonly<{
  kind: "acquired";
  role: WorkerSingletonRole;
  fence: WorkerFence;
  closeGracefully(): Promise<void>;
}>;

export type WorkerSingletonResult =
  | WorkerSingletonLease
  | Readonly<{ kind: "already-running"; role: "billing-worker-once" }>;

export type WorkerSingletonDependencies = Readonly<{
  createClient(databaseUrl: string): WorkerLockClient;
  terminate(code: number): void;
  reportFatal(message: string): void;
  schedule(callback: () => void): void;
  markNonzero?(): void;
}>;

const REAL_DEPENDENCIES: WorkerSingletonDependencies = Object.freeze({
  createClient: (databaseUrl) => new PgWorkerLockClient(databaseUrl),
  terminate: (code) => process.exit(code),
  reportFatal: (message) => console.error(message),
  schedule: (callback) => setImmediate(callback),
  markNonzero: () => { process.exitCode = 1; },
});

function exactBoolean(result: Readonly<{ rows: readonly LockRow[] }>, member: "locked" | "unlocked"): boolean {
  return result.rows.length === 1 && result.rows[0]?.[member] === true;
}

export async function acquireWorkerSingleton(input: Readonly<{
  role: WorkerSingletonRole;
  databaseUrl: string;
  dependencies?: WorkerSingletonDependencies;
}>): Promise<WorkerSingletonResult> {
  if (input.databaseUrl.trim() === "") throw new Error("Worker singleton requires DATABASE_URL.");
  const dependencies = input.dependencies ?? REAL_DEPENDENCIES;
  const client = dependencies.createClient(input.databaseUrl);
  const key = ROLE_KEYS[input.role];
  try {
    await client.connect();
    const result = await client.query(LOCK_SQL, [WORKER_LOCK_NAMESPACE, key]);
    if (!exactBoolean(result, "locked")) {
      await client.end().catch(() => undefined);
      if (input.role === "billing-worker-once") {
        return Object.freeze({ kind: "already-running" as const, role: input.role });
      }
      throw new Error("Worker singleton is already owned.");
    }
  } catch (error) {
    await client.end().catch(() => undefined);
    if (error instanceof Error && error.message === "Worker singleton is already owned.") throw error;
    throw new Error("Worker singleton acquisition failed.");
  }

  const fence = createWorkerFence();
  let gracefulClose = false;
  let terminationScheduled = false;
  const lost = (): void => {
    if (gracefulClose || !fence.latchFatal()) return;
    dependencies.markNonzero?.();
    dependencies.reportFatal("[worker-singleton] lock-lost");
    if (terminationScheduled) return;
    terminationScheduled = true;
    dependencies.schedule(() => dependencies.terminate(1));
  };
  client.on("error", lost);
  client.on("end", lost);

  return Object.freeze({
    kind: "acquired" as const,
    role: input.role,
    fence,
    async closeGracefully(): Promise<void> {
      fence.assertOpen();
      gracefulClose = true;
      let unlocked = false;
      try {
        const result = await client.query(UNLOCK_SQL, [WORKER_LOCK_NAMESPACE, key]);
        unlocked = exactBoolean(result, "unlocked");
      } finally {
        await client.end().catch(() => undefined);
      }
      if (!unlocked) throw new Error("Worker singleton unlock failed.");
    },
  });
}

export const WORKER_SINGLETON_SQL = Object.freeze({ lock: LOCK_SQL, unlock: UNLOCK_SQL });
