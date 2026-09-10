/**
 * A store VIEW whose `listNonTerminalActions` answers from a snapshot taken
 * before a concurrent sender moved the rows (QUANT-GRID R5.2, audit A2).
 *
 * This is the only honest way to drive the race offline. Recovery reads its
 * work list once and then CASes each action on the `row_version` it saw, so a
 * recovery that started before the sender's `intended → submitted` CAS is
 * exactly a recovery holding a stale snapshot. Handing it one — rather than
 * hand-calling `abortIntent` with an old version — is what makes the test a
 * test of `recoverPending` instead of a test of the store.
 *
 * Everything else delegates to the real store, unbound from the proxy so a
 * backend with private fields still works, and every `abortIntent` verdict is
 * recorded: "the CAS lost" is the fact the assertion is about.
 */
import type {
  QuantActionRow,
  QuantCasResult,
  QuantJobStore,
} from "../../src/store/quantJobs.js";

export type StaleSnapshotView = {
  /** Pass this as `QuantReconcileDeps.store`. */
  readonly store: QuantJobStore;
  /** Every `abortIntent` verdict the recovery produced, in order. */
  readonly abortVerdicts: readonly ("ok" | "conflict")[];
};

export function withStaleActionSnapshot(
  store: QuantJobStore,
  snapshot: readonly QuantActionRow[],
): StaleSnapshotView {
  const abortVerdicts: ("ok" | "conflict")[] = [];
  const view = new Proxy(store, {
    get(target: QuantJobStore, property: string | symbol): unknown {
      if (property === "listNonTerminalActions") {
        return async (): Promise<readonly QuantActionRow[]> =>
          snapshot.map((row) => ({ ...row }));
      }
      if (property === "abortIntent") {
        return async (
          input: Parameters<QuantJobStore["abortIntent"]>[0],
        ): Promise<QuantCasResult<QuantActionRow>> => {
          const result = await target.abortIntent(input);
          abortVerdicts.push(result.kind);
          return result;
        };
      }
      const value = Reflect.get(target as object, property) as unknown;
      return typeof value === "function"
        ? (value as (...args: readonly unknown[]) => unknown).bind(target)
        : value;
    },
  });
  return { store: view, abortVerdicts };
}
