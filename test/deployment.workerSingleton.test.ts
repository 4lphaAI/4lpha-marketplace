import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { custom, getAddress } from "viem";
import { bsc } from "viem/chains";
import { runBillingWorkerOnce } from "../src/billing/worker.js";
import { MemoryBillingStore } from "../src/billing/store.js";
import { createLpChainReaders } from "../src/lp/readers.js";
import { createVenusChainReaders } from "../src/venus/readers.js";
import { readVenusUnknownHold } from "../src/venus/worker.js";
import { MemoryExecutionJournal, reconcile } from "../src/store/journal.js";
import type { WalletProvider } from "../src/core/types.js";
import {
  WORKER_LOCK_NAMESPACE,
  WORKER_SINGLETON_SQL,
  acquireWorkerSingleton,
  createWorkerGracefulDrain,
  fenceWorkerDependency,
  fenceWorkerFunction,
  waitForWorkerDelay,
  type WorkerLockClient,
  type WorkerSingletonDependencies,
} from "../src/deployment/workerSingleton.js";

type QueryCall = Readonly<{ text: string; values: readonly number[] }>;

class FakeLockDatabase {
  readonly owners = new Set<number>();
  readonly clients: FakeLockClient[] = [];

  createClient(): FakeLockClient {
    const client = new FakeLockClient(this);
    this.clients.push(client);
    return client;
  }
}

class FakeLockClient implements WorkerLockClient {
  readonly calls: QueryCall[] = [];
  readonly #events = new EventEmitter();
  readonly #database: FakeLockDatabase;
  #ownedKey: number | undefined;
  #connected = false;
  unlockResult = true;

  constructor(database: FakeLockDatabase) {
    this.#database = database;
  }

  async connect(): Promise<void> {
    this.#connected = true;
  }

  async query(text: string, values: readonly number[]): Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>> {
    this.calls.push({ text, values: [...values] });
    assert.equal(this.#connected, true);
    const roleKey = values[1];
    if (roleKey === undefined) throw new Error("missing role key");
    if (text === WORKER_SINGLETON_SQL.lock) {
      if (this.#database.owners.has(roleKey)) return { rows: [{ locked: false }] };
      this.#database.owners.add(roleKey);
      this.#ownedKey = roleKey;
      return { rows: [{ locked: true }] };
    }
    if (text === WORKER_SINGLETON_SQL.unlock) {
      if (!this.unlockResult || this.#ownedKey !== roleKey) return { rows: [{ unlocked: false }] };
      this.#database.owners.delete(roleKey);
      this.#ownedKey = undefined;
      return { rows: [{ unlocked: true }] };
    }
    throw new Error("unexpected SQL");
  }

  on(event: "error" | "end", listener: ((error: Error) => void) | (() => void)): this {
    this.#events.on(event, listener);
    return this;
  }

  async end(): Promise<void> {
    this.#connected = false;
    if (this.#ownedKey !== undefined) this.#database.owners.delete(this.#ownedKey);
    this.#ownedKey = undefined;
    this.#events.emit("end");
  }

  lose(): void {
    this.#connected = false;
    if (this.#ownedKey !== undefined) this.#database.owners.delete(this.#ownedKey);
    this.#ownedKey = undefined;
    this.#events.emit("end");
  }
}

function dependencies(database: FakeLockDatabase): Readonly<{
  value: WorkerSingletonDependencies;
  scheduled: Array<() => void>;
  exits: number[];
  reports: string[];
}> {
  const scheduled: Array<() => void> = [];
  const exits: number[] = [];
  const reports: string[] = [];
  return {
    scheduled,
    exits,
    reports,
    value: {
      createClient: () => database.createClient(),
      terminate: (code) => { exits.push(code); },
      reportFatal: (message) => { reports.push(message); },
      schedule: (callback) => { scheduled.push(callback); },
    },
  };
}

test("worker singleton uses the fixed namespace/role key and graceful unlock", async () => {
  const database = new FakeLockDatabase();
  const deps = dependencies(database);
  const result = await acquireWorkerSingleton({
    role: "lp-worker",
    databaseUrl: "postgres://fixture",
    dependencies: deps.value,
  });
  assert.equal(result.kind, "acquired");
  if (result.kind !== "acquired") return;
  assert.deepEqual(database.clients[0]?.calls[0], {
    text: WORKER_SINGLETON_SQL.lock,
    values: [WORKER_LOCK_NAMESPACE, 1],
  });
  await result.closeGracefully();
  assert.deepEqual(database.clients[0]?.calls[1], {
    text: WORKER_SINGLETON_SQL.unlock,
    values: [WORKER_LOCK_NAMESPACE, 1],
  });
  assert.deepEqual(deps.exits, []);
});

test("billing overlap returns the closed already-running result", async () => {
  const database = new FakeLockDatabase();
  const deps = dependencies(database);
  const first = await acquireWorkerSingleton({ role: "billing-worker-once", databaseUrl: "postgres://fixture", dependencies: deps.value });
  assert.equal(first.kind, "acquired");
  const second = await acquireWorkerSingleton({ role: "billing-worker-once", databaseUrl: "postgres://fixture", dependencies: deps.value });
  assert.deepEqual(second, { kind: "already-running", role: "billing-worker-once" });
  if (first.kind === "acquired") await first.closeGracefully();
});

test("daemon overlap refuses before work", async () => {
  const database = new FakeLockDatabase();
  const deps = dependencies(database);
  const first = await acquireWorkerSingleton({ role: "venus-worker", databaseUrl: "postgres://fixture", dependencies: deps.value });
  await assert.rejects(
    acquireWorkerSingleton({ role: "venus-worker", databaseUrl: "postgres://fixture", dependencies: deps.value }),
    /already owned/u,
  );
  if (first.kind === "acquired") await first.closeGracefully();
});

test("lock loss latches fatal before a paused external boundary and replacement acquisition", async () => {
  const database = new FakeLockDatabase();
  const deps = dependencies(database);
  const old = await acquireWorkerSingleton({ role: "lp-worker", databaseUrl: "postgres://fixture", dependencies: deps.value });
  assert.equal(old.kind, "acquired");
  if (old.kind !== "acquired") return;
  let crossed = 0;
  const boundary = fenceWorkerFunction(old.fence, () => { crossed += 1; });
  database.clients[0]?.lose();
  const replacement = await acquireWorkerSingleton({ role: "lp-worker", databaseUrl: "postgres://fixture", dependencies: deps.value });
  assert.equal(replacement.kind, "acquired");
  assert.equal(old.fence.signal.aborted, true);
  assert.throws(boundary, /authority was lost/u);
  assert.equal(crossed, 0);
  assert.deepEqual(deps.reports, ["[worker-singleton] lock-lost"]);
  assert.equal(deps.scheduled.length, 1);
  deps.scheduled[0]?.();
  assert.deepEqual(deps.exits, [1]);
  if (replacement.kind === "acquired") await replacement.closeGracefully();
});

test("dependency proxy re-checks the fence at every method call", async () => {
  const database = new FakeLockDatabase();
  const deps = dependencies(database);
  const lease = await acquireWorkerSingleton({ role: "venus-worker", databaseUrl: "postgres://fixture", dependencies: deps.value });
  assert.equal(lease.kind, "acquired");
  if (lease.kind !== "acquired") return;
  const target = {
    value: 0,
    mutate(): void { this.value += 1; },
  };
  const guarded = fenceWorkerDependency(lease.fence, target);
  guarded.mutate();
  assert.equal(target.value, 1);
  database.clients[0]?.lose();
  assert.throws(() => guarded.mutate(), /authority was lost/u);
  assert.equal(target.value, 1);
});

test("unlock false is a nonzero-worthy failure", async () => {
  const database = new FakeLockDatabase();
  const deps = dependencies(database);
  const lease = await acquireWorkerSingleton({ role: "billing-worker-once", databaseUrl: "postgres://fixture", dependencies: deps.value });
  assert.equal(lease.kind, "acquired");
  if (lease.kind !== "acquired") return;
  const client = database.clients[0];
  assert.ok(client);
  client.unlockResult = false;
  await assert.rejects(lease.closeGracefully(), /unlock failed/u);
});

test("money worker shells acquire the role lock before constructing external dependencies", async () => {
  const cases = [
    ["scripts/lp-worker.ts", 'role: "lp-worker"', "createLpChainReaders("],
    ["scripts/venus-worker.ts", 'role: "venus-worker"', "createAgentStore"],
    ["scripts/billing-worker.ts", 'role: "billing-worker-once"', "loadBillingProductionRuntime("],
  ] as const;
  for (const [path, roleMarker, firstExternal] of cases) {
    const source = await readFile(path, "utf8");
    const acquireAt = source.indexOf(roleMarker);
    const externalAt = source.indexOf(firstExternal, acquireAt);
    assert.notEqual(acquireAt, -1, `${path} lacks its role lock`);
    assert.notEqual(externalAt, -1, `${path} lacks its expected dependency construction`);
    assert.ok(acquireAt < externalAt, `${path} constructs an external dependency before locking`);
  }
});

test("lock loss cancels a registered cycle timer immediately and never unlocks", async () => {
  const database = new FakeLockDatabase();
  const deps = dependencies(database);
  let timerCallback: (() => void) | undefined;
  const cleared: unknown[] = [];
  const lease = await acquireWorkerSingleton({
    role: "lp-worker",
    databaseUrl: "postgres://fixture",
    dependencies: deps.value,
  });
  assert.equal(lease.kind, "acquired");
  if (lease.kind !== "acquired") return;
  const waiting = waitForWorkerDelay({
    delayMs: 60_000,
    fence: lease.fence,
    dependencies: {
      setTimer(callback) {
        timerCallback = callback;
        return "cycle-timer";
      },
      clearTimer(handle) { cleared.push(handle); },
    },
  });
  database.clients[0]?.lose();
  assert.equal(await waiting, "stopped");
  assert.deepEqual(cleared, ["cycle-timer"]);
  assert.equal(timerCallback === undefined, false);
  assert.equal(
    database.clients[0]?.calls.some((call) => call.text === WORKER_SINGLETON_SQL.unlock),
    false,
  );
});

test("graceful stop cancels the cycle timer but retains healthy unlock authority", async () => {
  const database = new FakeLockDatabase();
  const deps = dependencies(database);
  const lease = await acquireWorkerSingleton({
    role: "venus-worker",
    databaseUrl: "postgres://fixture",
    dependencies: deps.value,
  });
  assert.equal(lease.kind, "acquired");
  if (lease.kind !== "acquired") return;
  const graceful = new AbortController();
  const waiting = waitForWorkerDelay({
    delayMs: 60_000,
    fence: lease.fence,
    gracefulSignal: graceful.signal,
    dependencies: {
      setTimer: () => "graceful-timer",
      clearTimer: () => undefined,
    },
  });
  graceful.abort();
  assert.equal(await waiting, "stopped");
  assert.equal(lease.fence.isFatal(), false);
  await lease.closeGracefully();
  assert.equal(
    database.clients[0]?.calls.some((call) => call.text === WORKER_SINGLETON_SQL.unlock),
    true,
  );
});

test("lock loss marks nonzero synchronously before scheduling termination", async () => {
  const database = new FakeLockDatabase();
  const order: string[] = [];
  const base = dependencies(database);
  const lease = await acquireWorkerSingleton({
    role: "billing-worker-once",
    databaseUrl: "postgres://fixture",
    dependencies: {
      ...base.value,
      markNonzero: () => { order.push("nonzero"); },
      schedule: (callback) => {
        order.push("scheduled");
        base.scheduled.push(callback);
      },
    },
  });
  assert.equal(lease.kind, "acquired");
  database.clients[0]?.lose();
  assert.deepEqual(order, ["nonzero", "scheduled"]);
});

test("real billing worker cannot resume from a paused store read after replacement acquires", async () => {
  const database = new FakeLockDatabase();
  const deps = dependencies(database);
  let release: (() => void) | undefined;
  let entered = false;
  class PausedStore extends MemoryBillingStore {
    override async claimBillingWorkerAccountBatch(): Promise<readonly never[]> {
      entered = true;
      await new Promise<void>((resolve) => { release = resolve; });
      return [];
    }
  }
  const old = await acquireWorkerSingleton({
    role: "billing-worker-once",
    databaseUrl: "postgres://fixture",
    dependencies: deps.value,
  });
  assert.equal(old.kind, "acquired");
  if (old.kind !== "acquired") return;
  const running = runBillingWorkerOnce({
    workerFence: old.fence,
    store: new PausedStore(),
    now: () => 1_000,
    bscRpcOrigins: ["https://a.invalid", "https://b.invalid"],
    arbitrumRpcOrigins: ["https://c.invalid", "https://d.invalid"],
    readOracleObservation: async () => { throw new Error("unreachable"); },
    reconcileOgUsage: async () => { throw new Error("unreachable"); },
    reconcileX402Usage: async () => { throw new Error("unreachable"); },
    reconcileInvoice: async () => { throw new Error("unreachable"); },
    submitInvoice: async () => { throw new Error("unreachable"); },
  }, false);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(entered, true);
  database.clients[0]?.lose();
  const replacement = await acquireWorkerSingleton({
    role: "billing-worker-once",
    databaseUrl: "postgres://fixture",
    dependencies: deps.value,
  });
  assert.equal(replacement.kind, "acquired");
  release?.();
  await assert.rejects(running, /authority was lost/u);
  if (replacement.kind === "acquired") await replacement.closeGracefully();
});

test("graceful drain aborts waits immediately and enforces the exact bounded timeout", () => {
  let callback: (() => void) | undefined;
  const cleared: unknown[] = [];
  const exits: number[] = [];
  const reports: string[] = [];
  let delay = 0;
  const drain = createWorkerGracefulDrain({
    label: "fixture-worker",
    dependencies: {
      setTimer(next, delayMs) {
        callback = next;
        delay = delayMs;
        return "drain-timer";
      },
      clearTimer: (handle) => { cleared.push(handle); },
      terminate: (code) => { exits.push(code); },
      reportTimeout: (message) => { reports.push(message); },
    },
  });
  drain.requestStop();
  assert.equal(drain.signal.aborted, true);
  assert.equal(drain.isStopping(), true);
  assert.equal(delay, 30_000);
  callback?.();
  assert.deepEqual(reports, ["[fixture-worker] graceful drain exceeded 30000ms"]);
  assert.deepEqual(exits, [1]);
  drain.complete();
  assert.deepEqual(cleared, ["drain-timer"]);
});

test("completed graceful drain cannot later terminate", () => {
  let callback: (() => void) | undefined;
  const exits: number[] = [];
  const drain = createWorkerGracefulDrain({
    label: "fixture-worker",
    timeoutMs: 25,
    dependencies: {
      setTimer(next) { callback = next; return "timer"; },
      clearTimer: () => undefined,
      terminate: (code) => { exits.push(code); },
      reportTimeout: () => undefined,
    },
  });
  drain.requestStop();
  drain.complete();
  callback?.();
  assert.deepEqual(exits, []);
});

function finalizedBlockJson(): Readonly<Record<string, unknown>> {
  return {
    number: "0x64",
    hash: `0x${"11".repeat(32)}`,
    parentHash: `0x${"22".repeat(32)}`,
    nonce: `0x${"00".repeat(8)}`,
    sha3Uncles: `0x${"33".repeat(32)}`,
    logsBloom: `0x${"00".repeat(256)}`,
    transactionsRoot: `0x${"44".repeat(32)}`,
    stateRoot: `0x${"55".repeat(32)}`,
    receiptsRoot: `0x${"66".repeat(32)}`,
    miner: getAddress("0x1111111111111111111111111111111111111111"),
    mixHash: `0x${"77".repeat(32)}`,
    difficulty: "0x0",
    totalDifficulty: "0x0",
    extraData: "0x",
    size: "0x0",
    gasLimit: "0x0",
    gasUsed: "0x0",
    timestamp: "0x0",
    transactions: [],
    uncles: [],
    baseFeePerGas: null,
  };
}

test("LP reader already past connect cannot start its sequential RPC batch after replacement", async () => {
  const database = new FakeLockDatabase();
  const deps = dependencies(database);
  const old = await acquireWorkerSingleton({ role: "lp-worker", databaseUrl: "postgres://fixture", dependencies: deps.value });
  assert.equal(old.kind, "acquired");
  if (old.kind !== "acquired") return;
  let enterBlock: (() => void) | undefined;
  const blockEntered = new Promise<void>((resolve) => { enterBlock = resolve; });
  let releaseBlock: (() => void) | undefined;
  const blockPaused = new Promise<void>((resolve) => { releaseBlock = resolve; });
  const methods: string[] = [];
  const transport = custom({
    async request({ method }) {
      methods.push(method);
      if (method === "eth_chainId") return "0x38";
      if (method === "eth_getBlockByNumber") {
        enterBlock?.();
        await blockPaused;
        return finalizedBlockJson();
      }
      if (method === "eth_call") throw new Error("later LP RPC crossed");
      throw new Error(`unexpected ${method}`);
    },
  }, { retryCount: 0 });
  const readers = createLpChainReaders({
    network: { chain: bsc, chainId: 56, publicRpcUrl: "https://fixture.invalid" },
    workerFence: old.fence,
    transport: () => transport,
    nfpm: getAddress("0x2222222222222222222222222222222222222222"),
    factory: getAddress("0x3333333333333333333333333333333333333333"),
    quoterV2: getAddress("0x4444444444444444444444444444444444444444"),
    twapWindowSeconds: 300,
  });
  const running = readers.poolState(getAddress("0x5555555555555555555555555555555555555555"));
  await blockEntered;
  database.clients[0]?.lose();
  const replacement = await acquireWorkerSingleton({ role: "lp-worker", databaseUrl: "postgres://fixture", dependencies: deps.value });
  releaseBlock?.();
  await assert.rejects(running, /authority was lost/u);
  assert.deepEqual(methods, ["eth_chainId", "eth_getBlockByNumber"]);
  if (replacement.kind === "acquired") await replacement.closeGracefully();
});

test("Venus reader already past connect cannot start its sequential RPC batch after replacement", async () => {
  const database = new FakeLockDatabase();
  const deps = dependencies(database);
  const old = await acquireWorkerSingleton({ role: "venus-worker", databaseUrl: "postgres://fixture", dependencies: deps.value });
  assert.equal(old.kind, "acquired");
  if (old.kind !== "acquired") return;
  let enterBlock: (() => void) | undefined;
  const blockEntered = new Promise<void>((resolve) => { enterBlock = resolve; });
  let releaseBlock: (() => void) | undefined;
  const blockPaused = new Promise<void>((resolve) => { releaseBlock = resolve; });
  const methods: string[] = [];
  const transport = custom({
    async request({ method }) {
      methods.push(method);
      if (method === "eth_chainId") return "0x38";
      if (method === "eth_getBlockByNumber") {
        enterBlock?.();
        await blockPaused;
        return finalizedBlockJson();
      }
      if (method === "eth_call") throw new Error("later Venus RPC crossed");
      throw new Error(`unexpected ${method}`);
    },
  }, { retryCount: 0 });
  const readers = createVenusChainReaders({
    network: { chain: bsc, chainId: 56, publicRpcUrl: "https://fixture.invalid" },
    workerFence: old.fence,
    transport: () => transport,
    venue: {
      comptroller: getAddress("0x6666666666666666666666666666666666666666"),
      vBnb: getAddress("0x7777777777777777777777777777777777777777"),
      prime: getAddress("0x8888888888888888888888888888888888888888"),
      treasury: getAddress("0x9999999999999999999999999999999999999999"),
    },
    markets: [],
  });
  const running = readers.readAccount(getAddress("0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"));
  await blockEntered;
  database.clients[0]?.lose();
  const replacement = await acquireWorkerSingleton({ role: "venus-worker", databaseUrl: "postgres://fixture", dependencies: deps.value });
  releaseBlock?.();
  await assert.rejects(running, /authority was lost/u);
  assert.deepEqual(methods, ["eth_chainId", "eth_getBlockByNumber"]);
  if (replacement.kind === "acquired") await replacement.closeGracefully();
});

test("already-crossed submit becomes UNKNOWN under replacement and the Venus gate forbids resend", async () => {
  const database = new FakeLockDatabase();
  const deps = dependencies(database);
  const old = await acquireWorkerSingleton({
    role: "venus-worker",
    databaseUrl: "postgres://fixture",
    dependencies: deps.value,
  });
  assert.equal(old.kind, "acquired");
  if (old.kind !== "acquired") return;

  const journal = new MemoryExecutionJournal(() => 1_000);
  const oldJournal = fenceWorkerDependency(old.fence, journal);
  await oldJournal.begin({
    idempotencyKey: "venus-supply:fenced-submit",
    agentId: "agent-fenced",
    ownerAddress: getAddress("0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"),
    kind: "venusSupply",
    decisionId: "decision-fenced",
    nativeSpendWei: 1n,
  });

  let submitEnteredResolve: (() => void) | undefined;
  const submitEntered = new Promise<void>((resolve) => { submitEnteredResolve = resolve; });
  let releaseSubmit: (() => void) | undefined;
  const submitPaused = new Promise<void>((resolve) => { releaseSubmit = resolve; });
  let submissions = 0;
  const submitter = fenceWorkerDependency(old.fence, {
    async submit(): Promise<Readonly<{ callsId: `0x${string}` }>> {
      submissions += 1;
      submitEnteredResolve?.();
      await submitPaused;
      // The relay may have accepted this before the response came back. The
      // old process must exit without claiming either success or safe retry.
      return { callsId: `0x${"12".repeat(32)}` };
    },
  });

  const inFlight = submitter.submit();
  await submitEntered;
  database.clients[0]?.lose();
  const replacement = await acquireWorkerSingleton({
    role: "venus-worker",
    databaseUrl: "postgres://fixture",
    dependencies: deps.value,
  });
  assert.equal(replacement.kind, "acquired");
  releaseSubmit?.();
  await assert.rejects(inFlight, /authority was lost/u);
  assert.equal(submissions, 1);

  if (replacement.kind !== "acquired") return;
  let relayPolls = 0;
  const replacementJournal = fenceWorkerDependency(replacement.fence, journal);
  const provider = fenceWorkerDependency(replacement.fence, {
    async awaitExecution(): Promise<never> {
      relayPolls += 1;
      throw new Error("a row without callsId must not be polled");
    },
  }) as unknown as WalletProvider;
  const summary = await reconcile({
    provider,
    journal: replacementJournal,
    resolveWallet: async () => null,
    minRowAgeMs: 0,
  });
  assert.deepEqual(summary.held, ["venus-supply:fenced-submit"]);
  assert.equal(relayPolls, 0);
  const hold = await readVenusUnknownHold(replacementJournal, "agent-fenced");
  assert.equal(hold.held, true);
  assert.deepEqual(hold.keys, ["venus-supply:fenced-submit"]);
  // `evaluateAgent` consumes this exact typed gate before any supply submit;
  // therefore the replacement cannot turn ambiguity into a second transfer.
  assert.equal(submissions, 1);
  await replacement.closeGracefully();
});
